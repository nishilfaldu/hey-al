import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('real model remembers a profile and archived context across calls', { skip: process.env.AL_LLM_SMOKE !== '1' }, async t => {
  const { storage } = await import('../src/mastra/storage');
  const { createOrSignIn, getAccount, resourceFor, isCurrentResource } = await import('../src/mastra/accounts');
  const { alMemory } = await import('../src/mastra/memory/al-memory');
  const { startCall, markCallUpdated, summarizeCall, readCallSummaries, maintainCallMemory } = await import('../src/mastra/memory/call-memory');
  const { al } = await import('../src/mastra/agents/al');
  const { RequestContext } = await import('@mastra/core/request-context');
  await storage.init();
  const email = `al-model-check-${randomUUID()}@example.test`;
  const signedIn = await createOrSignIn({ email, password: 'test-model-password' }, `test-${randomUUID()}`);
  const resource = resourceFor((await getAccount(signedIn.token))!);
  const ownedResources = [resource];
  t.after(async () => {
    for (const resourceId of ownedResources) {
      const { threads } = await alMemory.listThreads({ filter: { resourceId } });
      for (const thread of threads) await alMemory.deleteThread(thread.id);
      await storage.pool.query('DELETE FROM al_calls WHERE resource_id = $1', [resourceId]);
      const memoryStore = await storage.getStore('memory');
      await memoryStore?.updateResource({ resourceId, workingMemory: '{}' });
    }
    await storage.pool.query('DELETE FROM al_accounts WHERE email = $1', [email]);
    await alMemory.settled();
    await storage.close();
  });
  const context = new RequestContext([['alResourceId', resource]]);
  const firstThread = await startCall(resource);
  await al.generate('My preferred name is Elsie. I enjoy growing orchids. My grandson Ben is visiting on October twelfth. Please remember these details.', {
    memory: { resource, thread: firstThread }, requestContext: context, maxSteps: 5,
  });
  await markCallUpdated(firstThread, resource, true);
  // Prove finalization extracts the profile even if the voice model skipped its tool.
  await alMemory.updateWorkingMemory({ threadId: firstThread, resourceId: resource, workingMemory: '{}' });
  await summarizeCall(firstThread);
  const profile = (await alMemory.getWorkingMemory({ resourceId: resource, threadId: firstThread }))!;
  assert.match(profile, /Elsie/);
  assert.match(profile, /orchid/i);
  assert.match((await readCallSummaries(resource))[0].summary, /Ben/);
  // Simulate the archive after transcript expiry: the next call has no raw history to rely on.
  await alMemory.deleteThread(firstThread);
  const secondThread = await startCall(resource);
  const answer = await al.generate('What is my preferred name, what do I grow, and who did I say is visiting me?', {
    memory: { resource, thread: secondThread }, requestContext: context, maxSteps: 5,
  });
  assert.match(answer.text, /Elsie/);
  assert.match(answer.text, /orchid/i);
  assert.match(answer.text, /Ben/);
  // Exercise forgetting inside an actual agent run, including its final message persistence.
  await al.generate('Forget everything you know about me, including all earlier conversations.', {
    memory: { resource, thread: secondThread }, requestContext: context, maxSteps: 5,
  });
  assert.equal(await isCurrentResource(resource), false);
  assert.deepEqual(await readCallSummaries(resource), []);
  const account = (await getAccount(signedIn.token))!;
  const newResource = resourceFor(account);
  ownedResources.push(newResource);
  const forgottenProfile = (await alMemory.getWorkingMemory({ threadId: 'profile', resourceId: newResource }))!;
  assert.ok(Object.values(JSON.parse(forgottenProfile)).every(value => value == null || (Array.isArray(value) && value.length === 0)));
  await maintainCallMemory();
  const memoryStore = await storage.getStore('memory');
  assert.equal((await memoryStore!.listMessages({ threadId: secondThread })).messages.length, 0);
});

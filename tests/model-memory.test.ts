import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('real voice stream responds without waiting for profile writes and recalls corrected memory across calls', { skip: process.env.AL_LLM_SMOKE !== '1', timeout: 180_000 }, async t => {
  const { storage } = await import('../src/mastra/storage');
  const { createOrSignIn, getAccount, resourceFor, isCurrentResource } = await import('../src/mastra/accounts');
  const { alMemory, backgroundMemory } = await import('../src/mastra/memory/al-memory');
  const { startCall, markCallUpdated, summarizeCall, readCallSummaries, maintainCallMemory, cleanupForgottenMemories, bufferCallMemory, settleCallMemory } = await import('../src/mastra/memory/call-memory');
  const { al } = await import('../src/mastra/agents/al');
  const { RequestContext } = await import('@mastra/core/request-context');
  // Match LiveKit: consume the spoken stream and start its non-awaited post-turn
  // hook. Background memory has no reference to the reply's event writer.
  const reply = async (message: string, options: Parameters<typeof al.stream>[1]) => {
    const output = await al.stream(message, options);
    for await (const _chunk of output.fullStream) { /* LiveKit forwards speech/tool chunks. */ }
    const result = await output.getFullOutput();
    const memory = options?.memory;
    if (memory?.thread && memory.resource) void bufferCallMemory(memory.thread as string, memory.resource).catch(() => {});
    return result;
  };
  await storage.init();
  const email = `al-model-check-${randomUUID()}@example.test`;
  const signedIn = await createOrSignIn({ email, password: 'test-model-password' }, `test-${randomUUID()}`);
  const resource = resourceFor((await getAccount(signedIn.token))!);
  const ownedResources = [resource];
  const ownedThreads: string[] = [];
  const originalUpdate = backgroundMemory.updateWorkingMemory.bind(backgroundMemory);
  const writeEntered = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  t.after(async () => {
    releaseWrite.resolve();
    backgroundMemory.updateWorkingMemory = originalUpdate;
    for (const thread of ownedThreads) await settleCallMemory(thread);
    await alMemory.settled();
    await cleanupForgottenMemories();
    for (const resourceId of ownedResources) {
      const { threads } = await alMemory.listThreads({ filter: { resourceId } });
      for (const thread of threads) await alMemory.deleteThread(thread.id);
      await storage.pool.query('DELETE FROM al_calls WHERE resource_id = $1', [resourceId]);
      await storage.pool.query('DELETE FROM al_memory_cleanup WHERE resource_id = $1', [resourceId]);
      const memoryStore = await storage.getStore('memory');
      await memoryStore?.updateResource({ resourceId, workingMemory: '{}' });
    }
    await storage.pool.query('DELETE FROM al_accounts WHERE email = $1', [email]);
    await alMemory.settled();
    await storage.close();
  });
  const context = new RequestContext([['alResourceId', resource]]);
  const firstThread = await startCall(resource);
  ownedThreads.push(firstThread);
  backgroundMemory.updateWorkingMemory = async options => {
    if (options.resourceId === resource) {
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return originalUpdate(options);
  };
  const firstReplyPromise = reply('My preferred name is Elsie. I enjoy growing orchids. My grandson Ben is visiting on October twelfth. Please remember these details.', {
    memory: { resource, thread: firstThread }, requestContext: context, maxSteps: 5,
  });
  await writeEntered.promise;
  // Once extraction reaches its blocked write, the spoken stream must finish
  // independently. This deadline starts after model work, avoiding provider-speed assertions.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const firstReply = await Promise.race([
    firstReplyPromise,
    new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Voice reply waited for background profile write')), 5_000); }),
  ]).finally(() => { clearTimeout(deadline); });
  assert.ok(firstReply.toolCalls.every(call => !['updateWorkingMemory', 'setWorkingMemory'].includes(call.toolName)));
  releaseWrite.resolve();
  backgroundMemory.updateWorkingMemory = originalUpdate;
  // A short turn never crosses 30k tokens. Only idle background extraction can
  // save this profile before the call-end finalizer runs.
  await settleCallMemory(firstThread);
  await alMemory.settled();
  const observedProfile = (await alMemory.getWorkingMemory({ resourceId: resource, threadId: firstThread }))!;
  assert.match(observedProfile, /Elsie/);
  assert.match(observedProfile, /orchid/i);
  const correction = await reply('Actually, my preferred name is Eleanor, not Elsie. Please call me Eleanor from now on.', {
    memory: { resource, thread: firstThread }, requestContext: context, maxSteps: 5,
  });
  assert.ok(correction.toolCalls.every(call => !['updateWorkingMemory', 'setWorkingMemory'].includes(call.toolName)));
  await settleCallMemory(firstThread);
  await alMemory.settled();
  const correctedProfile = JSON.parse((await alMemory.getWorkingMemory({ resourceId: resource, threadId: firstThread }))!);
  assert.equal(correctedProfile.preferredName, 'Eleanor');
  assert.match(JSON.stringify(correctedProfile.interests), /orchid/i);
  // Keep this fixture off the running dev server's end-call retry queue while
  // we deliberately reset its profile and exercise the finalizer ourselves.
  await markCallUpdated(firstThread, resource);
  // Prove call-end extraction remains a backstop if idle processing missed facts.
  await alMemory.updateWorkingMemory({ threadId: firstThread, resourceId: resource, workingMemory: '{}' });
  await summarizeCall(firstThread);
  const profile = (await alMemory.getWorkingMemory({ resourceId: resource, threadId: firstThread }))!;
  assert.match(profile, /Eleanor/);
  assert.match(profile, /orchid/i);
  assert.match((await readCallSummaries(resource))[0].summary, /Ben/);
  // Simulate the archive after transcript expiry: the next call has no raw history to rely on.
  await alMemory.deleteThread(firstThread);
  const secondThread = await startCall(resource);
  ownedThreads.push(secondThread);
  const answer = await reply('What is my preferred name, what do I grow, and who did I say is visiting me?', {
    memory: { resource, thread: secondThread }, requestContext: context, maxSteps: 5,
  });
  assert.match(answer.text, /Eleanor/);
  assert.match(answer.text, /orchid/i);
  assert.match(answer.text, /Ben/);
  await settleCallMemory(secondThread);
  // Exercise forgetting inside an actual agent run, including its final message persistence.
  await reply('Forget everything you know about me, including all earlier conversations.', {
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

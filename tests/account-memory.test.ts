import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

// Integration checks use isolated test accounts and remove only their own rows.
test('account identity, memory isolation, retention and forgetting in Postgres', { skip: !process.env.DATABASE_URL }, async t => {
  const { storage } = await import('../src/mastra/storage');
  const accounts = await import('../src/mastra/accounts');
  const calls = await import('../src/mastra/memory/call-memory');
  const { alMemory, mergeProfileUpdates } = await import('../src/mastra/memory/al-memory');
  await storage.init();
  await accounts.ensureAppTables();
  const emailA = `al-check-${randomUUID()}@example.test`;
  const emailB = `al-check-${randomUUID()}@example.test`;
  const password = 'hackathon-test-password';
  const ownedResources: string[] = [];
  t.after(async () => {
    await calls.cleanupForgottenMemories();
    await alMemory.settled();
    for (const resourceId of ownedResources) {
      const { threads } = await alMemory.listThreads({ filter: { resourceId } });
      for (const thread of threads) await alMemory.deleteThread(thread.id);
      await storage.pool.query('DELETE FROM al_calls WHERE resource_id = $1', [resourceId]);
      await storage.pool.query('DELETE FROM al_memory_cleanup WHERE resource_id = $1', [resourceId]);
      const memoryStore = await storage.getStore('memory');
      await memoryStore?.updateResource({ resourceId, workingMemory: '{}' });
    }
    await storage.pool.query('DELETE FROM al_accounts WHERE email = ANY($1)', [[emailA, emailB]]);
    await alMemory.settled();
    await storage.close();
  });
  const first = await accounts.createOrSignIn({ email: emailA, password }, `test-${randomUUID()}`);
  const second = await accounts.createOrSignIn({ email: emailB, password }, `test-${randomUUID()}`);
  const accountA = (await accounts.getAccount(first.token))!;
  const accountB = (await accounts.getAccount(second.token))!;
  const resourceA = accounts.resourceFor(accountA);
  const resourceB = accounts.resourceFor(accountB);
  ownedResources.push(resourceA, resourceB);

  await t.test('a name correction preserves interests even if extraction fills unrelated arrays with defaults', () => {
    assert.deepEqual(mergeProfileUpdates({ preferredName: 'Elsie', interests: ['orchids'] }, {
      updatedFields: ['preferredName'], profile: { preferredName: 'Eleanor', interests: [] },
    }), { preferredName: 'Eleanor', interests: ['orchids'] });
    assert.deepEqual(mergeProfileUpdates({ interests: ['orchids'] }, {
      updatedFields: ['interests'], profile: { interests: [] },
    }), { interests: [] });
  });

  await t.test('new email creates one account; returning email verifies its password', async () => {
    const signedIn = await accounts.createOrSignIn({ email: emailA.toUpperCase(), password }, `test-${randomUUID()}`);
    assert.equal(signedIn.user.id, first.user.id);
    await assert.rejects(accounts.createOrSignIn({ email: emailA, password: 'wrong-password' }, `test-${randomUUID()}`), { status: 401 });
    const saved = await storage.pool.query('SELECT password_hash FROM al_accounts WHERE id = $1', [first.user.id]);
    assert.notEqual(saved.rows[0].password_hash, password);
    assert.equal(await accounts.verifyPassword(password, saved.rows[0].password_hash), true);
    assert.equal(await accounts.verifyPassword(password, 'invalid'), false);
  });

  await t.test('sessions store only token hashes and are revoked on sign-out', async () => {
    const saved = await storage.pool.query('SELECT token_hash FROM al_sessions WHERE account_id = $1', [first.user.id]);
    assert.ok(saved.rows.every(row => row.token_hash !== first.token));
    await accounts.signOut(first.token);
    assert.equal(await accounts.getAccount(first.token), null);
  });

  const threadA = await calls.startCall(resourceA);
  const threadB = await calls.startCall(resourceB);
  await alMemory.createThread({ threadId: threadA, resourceId: resourceA });
  await alMemory.createThread({ threadId: threadB, resourceId: resourceB });
  await alMemory.updateWorkingMemory({ threadId: threadA, resourceId: resourceA, workingMemory: JSON.stringify({ preferredName: 'Margaret', interests: ['gardening'] }) });
  await alMemory.saveMessages({ messages: [{ id: randomUUID(), threadId: threadA, resourceId: resourceA, role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'I enjoy gardening.' }] }, type: 'text', createdAt: new Date() }] });

  await t.test('profile and summaries never cross account boundaries', async () => {
    assert.match((await alMemory.getWorkingMemory({ threadId: threadA, resourceId: resourceA }))!, /Margaret/);
    assert.equal(await alMemory.getWorkingMemory({ threadId: threadB, resourceId: resourceB }), null);
    assert.equal(await alMemory.getThreadById({ threadId: threadA, resourceId: resourceB }), null);
    await storage.pool.query("UPDATE al_calls SET summary = 'Margaret enjoys gardening.', summarized_at = now() WHERE thread_id = $1", [threadA]);
    assert.equal((await calls.readCallSummaries(resourceA)).length, 1);
    assert.equal((await calls.readCallSummaries(resourceB)).length, 0);
  });

  await t.test('seven-day purge removes transcripts and OM, while retaining summary and profile', async () => {
    await storage.pool.query("UPDATE al_calls SET started_at = now() - interval '8 days', updated_at = now() - interval '8 days' WHERE thread_id = $1", [threadA]);
    await calls.maintainCallMemory();
    assert.equal(await alMemory.getThreadById({ threadId: threadA }), null);
    assert.equal((await calls.readCallSummaries(resourceA))[0].summary, 'Margaret enjoys gardening.');
    assert.match((await alMemory.getWorkingMemory({ threadId: threadA, resourceId: resourceA }))!, /gardening/);
    const memoryStore = await storage.getStore('memory');
    assert.equal(await memoryStore!.getObservationalMemory(threadA, resourceA), null);
  });

  await t.test('cancelled connections without a transcript do not stay in the retry queue', async () => {
    const cancelled = await calls.startCall(resourceB);
    await calls.markCallUpdated(cancelled, resourceB, true);
    await calls.summarizeCall(cancelled);
    const saved = await storage.pool.query('SELECT summary, summarized_at FROM al_calls WHERE thread_id = $1', [cancelled]);
    assert.equal(saved.rows[0].summary, '');
    assert.ok(saved.rows[0].summarized_at);
  });

  await t.test('forget rotates memory identity, removes all recall sources and rejects stale summary work', async () => {
    await calls.forgetMemories(resourceA, { preferredName: 'Margaret' });
    assert.equal(await accounts.isCurrentResource(resourceA), false);
    assert.deepEqual(await calls.readCallSummaries(resourceA), []);
    await calls.summarizeCall(threadA);
    const updated = await storage.pool.query('SELECT memory_version FROM al_accounts WHERE id = $1', [first.user.id]);
    const nextResource = accounts.resourceFor({ ...accountA, memory_version: updated.rows[0].memory_version });
    ownedResources.push(nextResource);
    const profile = (await alMemory.getWorkingMemory({ threadId: 'profile', resourceId: nextResource }))!;
    assert.match(profile, /Margaret/);
    assert.doesNotMatch(profile, /gardening/);
    assert.deepEqual(await calls.readCallSummaries(nextResource), []);
    await calls.cleanupForgottenMemories();
  });

  await t.test('forget returns while deletion is blocked, and failed cleanup is durably retried', async () => {
    const activeThread = await calls.startCall(resourceB);
    await alMemory.createThread({ threadId: activeThread, resourceId: resourceB });
    await alMemory.updateWorkingMemory({ threadId: activeThread, resourceId: resourceB, workingMemory: '{"preferredName":"Ben","interests":["gardening"]}' });
    const originalDelete = alMemory.deleteThread.bind(alMemory);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    alMemory.deleteThread = async threadId => {
      if (threadId === activeThread) {
        entered.resolve();
        await release.promise;
        throw new Error('Simulated background cleanup failure');
      }
      return originalDelete(threadId);
    };
    try {
      const result = await calls.forgetMemories(resourceB, { preferredName: 'Ben' });
      assert.equal(result.memoryInvalidated, true);
      assert.equal(result.cleanup, 'queued');
      await entered.promise;
      assert.equal(await accounts.isCurrentResource(resourceB), false);
      assert.ok(await alMemory.getThreadById({ threadId: activeThread }), 'bulk deletion is still blocked');
      const nextAccount = (await accounts.getAccount(second.token))!;
      const nextResource = accounts.resourceFor(nextAccount);
      ownedResources.push(nextResource);
      assert.deepEqual(JSON.parse((await alMemory.getWorkingMemory({ threadId: 'profile', resourceId: nextResource }))!), { preferredName: 'Ben' });
      await assert.rejects(calls.forgetMemories(resourceB, {}), /old memory profile/);
      release.resolve();
      await calls.cleanupForgottenMemories();
      assert.equal((await storage.pool.query('SELECT 1 FROM al_memory_cleanup WHERE resource_id = $1', [resourceB])).rowCount, 1);
      alMemory.deleteThread = originalDelete;
      await calls.cleanupForgottenMemories();
      assert.equal(await alMemory.getThreadById({ threadId: activeThread }), null);
      assert.equal((await storage.pool.query('SELECT 1 FROM al_memory_cleanup WHERE resource_id = $1', [resourceB])).rowCount, 0);
    } finally {
      release.resolve();
      alMemory.deleteThread = originalDelete;
    }
  });

  await t.test('login attempts are bounded', async () => {
    for (let i = 0; i < 10; i++) {
      try { await accounts.createOrSignIn({ email: emailB, password: 'wrong-password' }, `test-${randomUUID()}`); }
      catch (error) { if (error instanceof accounts.AccountError && error.status === 429) return; }
    }
    await assert.rejects(accounts.createOrSignIn({ email: emailB, password }, `test-${randomUUID()}`), { status: 429 });
  });
});

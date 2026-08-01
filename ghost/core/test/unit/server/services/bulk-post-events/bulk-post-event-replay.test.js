const assert = require('node:assert/strict');
const sinon = require('sinon');
const {BulkPostEventReplay} = require('../../../../../core/server/services/bulk-post-events/bulk-post-event-replay');
const {PostsBulkAddTagsEvent} = require('../../../../../core/shared/events-ts');

function fakeModel(attributes) {
    return {
        get: attribute => attributes[attribute]
    };
}

function createReplay({posts = [], tags = []} = {}) {
    const domainEvents = {subscribe: sinon.stub()};
    const jobsService = {addJob: sinon.stub()};
    const events = {emit: sinon.stub()};
    const models = {
        Post: {findAll: sinon.stub().resolves({models: posts})},
        Tag: {findAll: sinon.stub().resolves({models: tags})}
    };

    const replay = new BulkPostEventReplay({domainEvents, jobsService, events, models});

    return {replay, domainEvents, jobsService, events, models};
}

// Runs every job the service queued, in order, so a test can assert on what
// the jobs emit rather than on the queueing itself.
async function runQueuedJobs(jobsService) {
    for (const call of jobsService.addJob.getCalls()) {
        await call.args[0].job();
    }
}

describe('Unit: services/bulk-post-events/BulkPostEventReplay', function () {
    afterEach(function () {
        sinon.restore();
    });

    describe('subscribe', function () {
        it('replays the posts and tags carried by a bulk add tags event', async function () {
            const {replay, domainEvents, jobsService, events, models} = createReplay({
                posts: [fakeModel({id: 'post-1', type: 'post', status: 'published'})],
                tags: [fakeModel({id: 'tag-1'})]
            });

            replay.subscribe();

            const [EventClass, handler] = domainEvents.subscribe.firstCall.args;
            assert.equal(EventClass, PostsBulkAddTagsEvent);

            handler(PostsBulkAddTagsEvent.create(['post-1'], ['tag-1']));
            await runQueuedJobs(jobsService);

            assert.deepEqual(models.Post.findAll.firstCall.args[0].filter, 'id:[post-1]');
            assert.deepEqual(models.Tag.findAll.firstCall.args[0].filter, 'id:[tag-1]');
            assert.deepEqual(events.emit.getCalls().map(call => call.args[0]), [
                'post.tag.attached',
                'post.published.edited',
                'post.edited',
                'tag.attached'
            ]);
        });
    });

    describe('enqueue', function () {
        it('queues one job per chunk of 50 posts', function () {
            const {replay, jobsService} = createReplay();
            const postIds = Array.from({length: 120}, (value, index) => `post-${index}`);

            replay.enqueue({postIds, tagIds: []});

            const postJobs = jobsService.addJob.getCalls().filter(call => call.args[0].name === 'bulk-post-events');
            assert.equal(postJobs.length, 3);
        });

        it('queues a single tag job for the whole bulk edit', function () {
            const {replay, jobsService} = createReplay();
            const postIds = Array.from({length: 120}, (value, index) => `post-${index}`);

            replay.enqueue({postIds, tagIds: ['tag-1', 'tag-2']});

            const tagJobs = jobsService.addJob.getCalls().filter(call => call.args[0].name === 'bulk-post-tag-events');
            assert.equal(tagJobs.length, 1);
        });

        it('does not queue a tag job when no tags were attached', function () {
            const {replay, jobsService} = createReplay();

            replay.enqueue({postIds: ['post-1'], tagIds: []});

            const tagJobs = jobsService.addJob.getCalls().filter(call => call.args[0].name === 'bulk-post-tag-events');
            assert.equal(tagJobs.length, 0);
        });

        it('queues nothing when there are no affected posts', function () {
            const {replay, jobsService} = createReplay();

            replay.enqueue({postIds: [], tagIds: []});

            assert.equal(jobsService.addJob.called, false);
        });
    });

    describe('replayPostEvents', function () {
        it('loads the relations the URL service and webhook payloads read', async function () {
            const {replay, models} = createReplay({
                posts: [fakeModel({id: 'post-1', type: 'post', status: 'published'})]
            });

            await replay.replayPostEvents({postIds: ['post-1'], tagsAttached: true});

            const options = models.Post.findAll.firstCall.args[0];
            assert.deepEqual(options.withRelated, ['tags', 'authors', 'authors.roles', 'email', 'tiers', 'newsletter', 'count.clicks']);
            assert.equal(options.status, 'all');
            assert.deepEqual(options.context, {internal: true});
        });

        it('emits the events a single-post edit fires for a published post', async function () {
            const post = fakeModel({id: 'post-1', type: 'post', status: 'published'});
            const {replay, events} = createReplay({posts: [post]});

            await replay.replayPostEvents({postIds: ['post-1'], tagsAttached: true});

            assert.deepEqual(events.emit.getCalls().map(call => call.args[0]), [
                'post.tag.attached',
                'post.published.edited',
                'post.edited'
            ]);
            assert.equal(events.emit.firstCall.args[1], post);
            assert.deepEqual(events.emit.firstCall.args[2], {context: {internal: true}});
        });

        it('does not emit published.edited for a draft', async function () {
            const {replay, events} = createReplay({
                posts: [fakeModel({id: 'post-1', type: 'post', status: 'draft'})]
            });

            await replay.replayPostEvents({postIds: ['post-1'], tagsAttached: true});

            assert.deepEqual(events.emit.getCalls().map(call => call.args[0]), [
                'post.tag.attached',
                'post.edited'
            ]);
        });

        it('emits page events for pages', async function () {
            const {replay, events} = createReplay({
                posts: [fakeModel({id: 'page-1', type: 'page', status: 'published'})]
            });

            await replay.replayPostEvents({postIds: ['page-1'], tagsAttached: true});

            assert.deepEqual(events.emit.getCalls().map(call => call.args[0]), [
                'page.tag.attached',
                'page.published.edited',
                'page.edited'
            ]);
        });

        it('omits the tag event when the bulk edit attached no tags', async function () {
            const {replay, events} = createReplay({
                posts: [fakeModel({id: 'post-1', type: 'post', status: 'published'})]
            });

            await replay.replayPostEvents({postIds: ['post-1'], tagsAttached: false});

            assert.deepEqual(events.emit.getCalls().map(call => call.args[0]), [
                'post.published.edited',
                'post.edited'
            ]);
        });

        it('does not query for an empty chunk', async function () {
            const {replay, models, events} = createReplay();

            await replay.replayPostEvents({postIds: [], tagsAttached: true});

            assert.equal(models.Post.findAll.called, false);
            assert.equal(events.emit.called, false);
        });
    });

    describe('replayTagEvents', function () {
        it('emits tag.attached once per tag', async function () {
            const tags = [fakeModel({id: 'tag-1'}), fakeModel({id: 'tag-2'})];
            const {replay, events} = createReplay({tags});

            await replay.replayTagEvents({tagIds: ['tag-1', 'tag-2']});

            assert.deepEqual(events.emit.getCalls().map(call => call.args[0]), [
                'tag.attached',
                'tag.attached'
            ]);
            assert.equal(events.emit.firstCall.args[1], tags[0]);
        });

        it('does not query without tags', async function () {
            const {replay, models} = createReplay();

            await replay.replayTagEvents({tagIds: []});

            assert.equal(models.Tag.findAll.called, false);
        });
    });
});

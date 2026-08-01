const assert = require('node:assert/strict');
const {setTimeout: sleep} = require('node:timers/promises');
const testUtils = require('../utils');
const {waitUntilFinished} = require('../utils/url-service-utils');
const models = require('../../core/server/models');
const UrlService = require('../../core/server/services/url/url-service');
const jobsService = require('../../core/server/services/jobs');
const bulkPostEvents = require('../../core/server/services/bulk-post-events').default;
const getPostServiceInstance = require('../../core/server/services/posts/posts-service-instance');

// Reproduces https://github.com/TryGhost/Ghost/issues/22255: a routes.yaml
// collection filtered on a tag, and posts that get that tag in bulk.
const ROUTES = [
    {identifier: 'tag-collection', filter: 'tags:[bulk-tag]', resourceType: 'posts', permalink: '/tagged/:slug/'},
    {identifier: 'index-collection', filter: null, resourceType: 'posts', permalink: '/:slug/'},
    {identifier: 'tags-router', filter: null, resourceType: 'tags', permalink: '/tag/:slug/'}
];

// The replay runs off the job queue, so the new URL lands a few ticks after the
// bulk edit resolves.
async function waitForUrl(urlService, resourceId, expectedUrl, timeout = 3000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        await jobsService.allSettled();
        await waitUntilFinished(urlService);

        if (urlService.getUrlByResourceId(resourceId) === expectedUrl) {
            return;
        }

        await sleep(50);
    }

    assert.equal(urlService.getUrlByResourceId(resourceId), expectedUrl);
}

describe('Integration: bulk tag edits and routing', function () {
    let urlService;
    let postsService;
    let post;

    beforeAll(testUtils.teardownDb);
    beforeAll(testUtils.setup('users:roles', 'posts'));
    afterAll(testUtils.teardownDb);

    beforeAll(async function () {
        bulkPostEvents.init();
        postsService = getPostServiceInstance();

        post = await models.Post.add({
            title: 'Bulk tagged',
            slug: 'bulk-tagged',
            status: 'published',
            lexical: testUtils.DataGenerator.markdownToLexical('bulk tag fixture')
        }, {context: {internal: true}});

        urlService = new UrlService();
        ROUTES.forEach(route => urlService.onRouterAddedType(route.identifier, route.filter, route.resourceType, route.permalink));
        urlService.init();

        await waitUntilFinished(urlService);
    });

    afterAll(function () {
        urlService.reset();
    });

    it('routes an untagged post through the index collection', function () {
        assert.equal(urlService.getUrlByResourceId(post.id), '/bulk-tagged/');
    });

    it('moves a post into the tag collection after a bulk tag add', async function () {
        // Datetime columns hold whole seconds, so age the post rather than
        // racing the clock for the `updated_at` assertion below.
        const updatedAtBefore = new Date(Date.now() - 60 * 1000);
        await models.Base.knex('posts').where('id', post.id).update({updated_at: updatedAtBefore});

        await postsService.bulkEdit({
            action: 'addTag',
            meta: {tags: [{name: 'Bulk Tag', slug: 'bulk-tag'}]}
        }, {
            filter: `id:${post.id}`,
            context: {internal: true}
        });

        await waitForUrl(urlService, post.id, '/tagged/bulk-tagged/');

        const reloaded = await models.Post.findOne({id: post.id, status: 'all'}, {context: {internal: true}});
        assert.ok(
            reloaded.get('updated_at') > updatedAtBefore,
            'bulk tag add bumps updated_at, like a single-post edit does'
        );
    });

    it('gives an existing tag a url once a bulk edit gives it published posts', async function () {
        // A tag only gets a URL once it has published posts, so this one has
        // none until the bulk edit attaches it.
        const tag = await models.Tag.add({
            name: 'Empty Tag',
            slug: 'empty-tag'
        }, {context: {internal: true}});

        assert.equal(urlService.getUrlByResourceId(tag.id), '/404/', 'a tag without published posts has no url');

        const taggedPost = await models.Post.add({
            title: 'Gets the empty tag',
            slug: 'gets-the-empty-tag',
            status: 'published',
            lexical: testUtils.DataGenerator.markdownToLexical('bulk tag fixture')
        }, {context: {internal: true}});

        await postsService.bulkEdit({
            action: 'addTag',
            meta: {tags: [{id: tag.id}]}
        }, {
            filter: `id:${taggedPost.id}`,
            context: {internal: true}
        });

        await waitForUrl(urlService, tag.id, '/tag/empty-tag/');
    });
});

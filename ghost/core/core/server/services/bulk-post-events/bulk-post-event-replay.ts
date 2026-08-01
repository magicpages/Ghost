// @ts-expect-error @tryghost/domain-events currently lacks type declarations.
import type DomainEvents from '@tryghost/domain-events';
import chunk from 'lodash/chunk';
import {PostsBulkAddTagsEvent} from '../../../shared/events-ts';

/**
 * Posts loaded per job. Bulk edits are unbounded — a filter can match every
 * post on the site — so the replay is split into jobs small enough that the
 * shared inline job queue (concurrency 3, also used by email batch sending)
 * keeps making progress between them.
 */
const CHUNK_SIZE = 50;

/**
 * Replayed events are Ghost's own doing, not a user request. Internal context
 * is what tells listeners that read it apart — webmention sending skips
 * internal events, webhooks (which only skip imports) still fire.
 */
const EVENT_OPTIONS = {context: {internal: true}};

/**
 * The relations the Admin API loads by default for a post, so a replayed event
 * carries the same payload a single-post edit would — the URL service reads
 * tags and authors off the model, and webhook consumers get the rest.
 */
const WITH_RELATED = ['tags', 'authors', 'authors.roles', 'email', 'tiers', 'newsletter', 'count.clicks'];

interface BookshelfModel {
    get(attribute: string): string | null;
}

interface BookshelfCollection {
    models: BookshelfModel[];
}

interface Models {
    Post: {findAll(options: object): Promise<BookshelfCollection>};
    Tag: {findAll(options: object): Promise<BookshelfCollection>};
}

interface ModelEvents {
    emit(name: string, model: BookshelfModel, options: object): void;
}

interface JobsService {
    addJob(options: {name: string; job: () => Promise<void>; offloaded: boolean}): unknown;
}

export interface BulkPostEventReplayDeps {
    domainEvents: Pick<DomainEvents, 'subscribe'>;
    jobsService: JobsService;
    events: ModelEvents;
    models: Models;
}

/**
 * Bulk post edits write with raw knex for speed, so they never pass through the
 * model layer and never fire the model events that routing, sitemaps and
 * webhooks are built on. A post that gets a tag in bulk therefore keeps its old
 * URL-service resource, and stays out of any `routes.yaml` collection filtered
 * on that tag until something else refreshes it.
 *
 * This service replays those model events once the bulk write has committed,
 * off the job queue so the request doesn't pay for the fan-out and a
 * five-thousand-post edit doesn't emit five thousand events in one tick.
 */
export class BulkPostEventReplay {
    readonly #domainEvents: Pick<DomainEvents, 'subscribe'>;
    readonly #jobsService: JobsService;
    readonly #events: ModelEvents;
    readonly #models: Models;

    constructor({domainEvents, jobsService, events, models}: BulkPostEventReplayDeps) {
        this.#domainEvents = domainEvents;
        this.#jobsService = jobsService;
        this.#events = events;
        this.#models = models;
    }

    subscribe(): void {
        this.#domainEvents.subscribe(PostsBulkAddTagsEvent, (event: PostsBulkAddTagsEvent) => {
            this.enqueue({postIds: event.data, tagIds: event.tagIds});
        });
    }

    /**
     * Queue the replay. Returns as soon as the jobs are queued — the events
     * themselves are emitted by the job queue.
     */
    enqueue({postIds = [], tagIds = []}: {postIds?: string[]; tagIds?: string[]}): void {
        for (const postIdChunk of chunk(postIds, CHUNK_SIZE)) {
            this.#jobsService.addJob({
                name: 'bulk-post-events',
                job: () => this.replayPostEvents({postIds: postIdChunk, tagsAttached: tagIds.length > 0}),
                offloaded: false
            });
        }

        // Once per bulk edit, not once per chunk: a tag's URL depends on
        // whether it has any published posts at all, so one event per tag is
        // enough to get it re-evaluated.
        if (tagIds.length > 0) {
            this.#jobsService.addJob({
                name: 'bulk-post-tag-events',
                job: () => this.replayTagEvents({tagIds}),
                offloaded: false
            });
        }
    }

    async replayPostEvents({postIds, tagsAttached}: {postIds: string[]; tagsAttached: boolean}): Promise<void> {
        if (postIds.length === 0) {
            return;
        }

        const posts = await this.#models.Post.findAll({
            filter: `id:[${postIds.join(',')}]`,
            status: 'all',
            withRelated: WITH_RELATED,
            context: {internal: true}
        });

        for (const post of posts.models) {
            this.#emitPostEvents(post, {tagsAttached});
        }
    }

    async replayTagEvents({tagIds}: {tagIds: string[]}): Promise<void> {
        if (tagIds.length === 0) {
            return;
        }

        const tags = await this.#models.Tag.findAll({
            filter: `id:[${tagIds.join(',')}]`,
            context: {internal: true}
        });

        for (const tag of tags.models) {
            this.#events.emit('tag.attached', tag, EVENT_OPTIONS);
        }
    }

    /**
     * Mirrors the events a single-post edit fires from `Post.onUpdated` and
     * `Post.handleAttachedModels`, for the changes a bulk tag add makes. The
     * one deliberate difference: the tag event goes out once per post rather
     * than once per attached tag, so tagging with five tags doesn't quintuple
     * the webhook fan-out for what subscribers read as a single change.
     */
    #emitPostEvents(post: BookshelfModel, {tagsAttached}: {tagsAttached: boolean}): void {
        const resourceType = post.get('type');

        if (tagsAttached) {
            this.#events.emit(`${resourceType}.tag.attached`, post, EVENT_OPTIONS);
        }

        if (post.get('status') === 'published') {
            this.#events.emit(`${resourceType}.published.edited`, post, EVENT_OPTIONS);
        }

        this.#events.emit(`${resourceType}.edited`, post, EVENT_OPTIONS);
    }
}

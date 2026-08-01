export class PostsBulkAddTagsEvent {
    data: string[];
    /**
     * Ids of the tags that were attached, so subscribers can replay the tag
     * events the raw bulk write skipped.
     */
    tagIds: string[];
    timestamp: Date;

    constructor(data: string[], tagIds: string[], timestamp: Date) {
        this.data = data;
        this.tagIds = tagIds;
        this.timestamp = timestamp;
    }

    static create(data: string[], tagIds: string[] = [], timestamp = new Date()) {
        return new PostsBulkAddTagsEvent(data, tagIds, timestamp);
    }
}

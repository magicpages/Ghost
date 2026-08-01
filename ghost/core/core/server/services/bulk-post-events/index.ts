import {BulkPostEventReplay} from './bulk-post-event-replay';

class BulkPostEventsServiceWrapper {
    service?: BulkPostEventReplay;

    init(): void {
        if (this.service) {
            // Already done
            return;
        }

        const domainEvents = require('@tryghost/domain-events');
        const jobsService = require('../jobs');
        const events = require('../../lib/common/events');
        const models = require('../../models');

        this.service = new BulkPostEventReplay({
            domainEvents,
            jobsService,
            events,
            models
        });

        this.service.subscribe();
    }
}

export default new BulkPostEventsServiceWrapper();

package poc4.sim.a.service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Stands in for the queue consumer that lives outside the real service. */
@Component
@ConditionalOnProperty(name = "service-a.export-worker", havingValue = "true", matchIfMissing = true)
public class ExportWorker {
    private final ExportService exports;

    public ExportWorker(ExportService exports) {
        this.exports = exports;
    }

    @Scheduled(fixedDelay = 500)
    public void poll() {
        while (exports.processNext()) {
            // drain everything that is due
        }
    }
}

package poc4.sim.a.service;

import poc4.sim.a.dto.ExportRequest;
import poc4.sim.a.dto.ExportStatus;

public interface ExportService {
    /** Queues the export and returns at once; a worker writes the CSV later. */
    ExportStatus request(ExportRequest request, String baseUrl);

    ExportStatus status(String requestId);

    /** Takes one queued export and completes it; returns false when there was none. */
    boolean processNext();

    /** Reads a finished CSV file for a signed download link; null when the link does not hold. */
    byte[] download(String fileName, long expires, String signature);
}

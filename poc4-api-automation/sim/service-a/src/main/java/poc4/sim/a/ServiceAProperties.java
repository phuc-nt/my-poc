package poc4.sim.a;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "service-a")
public class ServiceAProperties {
    /** Where the export worker writes CSV files; the real service writes to an object storage bucket. */
    private String exportDir = "/tmp/sim-exports";
    /** How long a queued export waits before the worker takes it, so that callers see the queued state. */
    private long exportDelayMs = 2000;
    /** Signs download links, the way a bucket signs presigned URLs. */
    private String fileSigningKey;
    private long downloadTtlSeconds = 300;

    public String getExportDir() { return exportDir; }
    public void setExportDir(String exportDir) { this.exportDir = exportDir; }
    public long getExportDelayMs() { return exportDelayMs; }
    public void setExportDelayMs(long exportDelayMs) { this.exportDelayMs = exportDelayMs; }
    public String getFileSigningKey() { return fileSigningKey; }
    public void setFileSigningKey(String fileSigningKey) { this.fileSigningKey = fileSigningKey; }
    public long getDownloadTtlSeconds() { return downloadTtlSeconds; }
    public void setDownloadTtlSeconds(long downloadTtlSeconds) { this.downloadTtlSeconds = downloadTtlSeconds; }
}

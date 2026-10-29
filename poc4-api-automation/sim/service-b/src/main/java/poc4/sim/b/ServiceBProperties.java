package poc4.sim.b;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "service-b")
public class ServiceBProperties {
    private String serviceAUrl;
    private String serviceAApiKey;

    public String getServiceAUrl() { return serviceAUrl; }
    public void setServiceAUrl(String serviceAUrl) { this.serviceAUrl = serviceAUrl; }
    public String getServiceAApiKey() { return serviceAApiKey; }
    public void setServiceAApiKey(String serviceAApiKey) { this.serviceAApiKey = serviceAApiKey; }
}

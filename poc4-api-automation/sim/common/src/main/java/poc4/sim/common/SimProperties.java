package poc4.sim.common;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Settings the real services take from AppConfig and Parameter Store; here they come from environment variables. */
@ConfigurationProperties(prefix = "sim")
public class SimProperties {
    private String internalApiKey;
    private String partnerApiKey;
    private String thirdPartyUrl;
    private String eventsUrl;
    private int downstreamTimeoutMs = 2000;

    public String getInternalApiKey() { return internalApiKey; }
    public void setInternalApiKey(String internalApiKey) { this.internalApiKey = internalApiKey; }
    public String getPartnerApiKey() { return partnerApiKey; }
    public void setPartnerApiKey(String partnerApiKey) { this.partnerApiKey = partnerApiKey; }
    public String getThirdPartyUrl() { return thirdPartyUrl; }
    public void setThirdPartyUrl(String thirdPartyUrl) { this.thirdPartyUrl = thirdPartyUrl; }
    public String getEventsUrl() { return eventsUrl; }
    public void setEventsUrl(String eventsUrl) { this.eventsUrl = eventsUrl; }
    public int getDownstreamTimeoutMs() { return downstreamTimeoutMs; }
    public void setDownstreamTimeoutMs(int downstreamTimeoutMs) { this.downstreamTimeoutMs = downstreamTimeoutMs; }
}

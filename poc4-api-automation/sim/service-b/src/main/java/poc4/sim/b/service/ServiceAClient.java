package poc4.sim.b.service;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import poc4.sim.b.ServiceBProperties;
import poc4.sim.common.ApiException;
import poc4.sim.common.DownstreamClient;
import poc4.sim.common.ErrorCode;

/** Calls Service A's internal endpoint with the API key. */
@Component
public class ServiceAClient {
    private final DownstreamClient client;
    private final ServiceBProperties props;

    public ServiceAClient(DownstreamClient client, ServiceBProperties props) {
        this.client = client;
        this.props = props;
    }

    /** Fails with E243 when Service A does not know the user and with E206 when the account is locked. */
    public void requireActiveUser(String userId) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Api-Key", props.getServiceAApiKey());
        ResponseEntity<JsonNode> response = client.call("service-a", HttpMethod.GET,
                props.getServiceAUrl() + "/internal/v1/users/{userId}", null, headers, userId);
        if (response.getStatusCode() == HttpStatus.NOT_FOUND) {
            throw new ApiException(ErrorCode.E243, "userId", "The user was not found");
        }
        if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
            throw new ApiException(ErrorCode.E611, null, "service-a answered " + response.getStatusCodeValue());
        }
        if (response.getBody().path("data").path("locked").asBoolean()) {
            throw new ApiException(ErrorCode.E206);
        }
    }
}

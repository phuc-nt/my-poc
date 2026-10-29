package poc4.sim.common;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

/**
 * HTTP client for other services and third parties. It passes the caller's X-One-Time-Uuid on, so one id follows a
 * request across services. A timeout, a refused connection or a 5xx answer becomes E611; a 4xx answer goes back to
 * the caller to map.
 */
@Component
public class DownstreamClient {
    private static final Logger log = LoggerFactory.getLogger(DownstreamClient.class);

    private final RestTemplate rest;

    public DownstreamClient(RestTemplateBuilder builder, SimProperties props) {
        this.rest = builder
                .setConnectTimeout(Duration.ofMillis(1000))
                .setReadTimeout(Duration.ofMillis(props.getDownstreamTimeoutMs()))
                .additionalInterceptors((request, body, execution) -> {
                    String id = Correlation.get();
                    if (id != null) {
                        request.getHeaders().set(ResultHeaders.REQUEST_UUID, id);
                    }
                    return execution.execute(request, body);
                })
                .errorHandler(new DefaultResponseErrorHandler() {
                    @Override
                    public boolean hasError(ClientHttpResponse response) {
                        return false;
                    }
                })
                .build();
    }

    public ResponseEntity<JsonNode> call(String name, HttpMethod method, String url, Object body, HttpHeaders headers,
                                         Object... uriVariables) {
        try {
            ResponseEntity<JsonNode> response =
                    rest.exchange(url, method, new HttpEntity<>(body, headers), JsonNode.class, uriVariables);
            if (response.getStatusCode().is5xxServerError()) {
                log.warn("{} answered {}", name, response.getStatusCodeValue());
                throw new ApiException(ErrorCode.E611, null, name + " failed");
            }
            return response;
        } catch (ResourceAccessException e) {
            log.warn("{} did not answer: {}", name, e.getMessage());
            throw new ApiException(ErrorCode.E611, null, name + " did not answer in time");
        }
    }
}

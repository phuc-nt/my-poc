package poc4.sim.common;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;

/** Stands in for the notification topic: publishes an event over HTTP. A failed publish is logged, not raised. */
@Component
public class EventPublisher {
    private static final Logger log = LoggerFactory.getLogger(EventPublisher.class);

    private final DownstreamClient client;
    private final SimProperties props;

    public EventPublisher(DownstreamClient client, SimProperties props) {
        this.client = client;
        this.props = props;
    }

    public void publish(String topic, String type, Object payload) {
        try {
            client.call("events", HttpMethod.POST, props.getEventsUrl() + "/events/v1/publish",
                    Map.of("topic", topic, "type", type, "payload", payload), null);
        } catch (ApiException e) {
            log.warn("event {} on {} was not published", type, topic);
        }
    }
}

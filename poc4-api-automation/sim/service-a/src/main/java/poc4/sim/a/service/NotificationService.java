package poc4.sim.a.service;

import poc4.sim.a.dto.PushRequest;
import poc4.sim.a.dto.PushResult;

public interface NotificationService {
    /** Sends a push notification to every device of the user. */
    PushResult push(String userId, PushRequest request);
}

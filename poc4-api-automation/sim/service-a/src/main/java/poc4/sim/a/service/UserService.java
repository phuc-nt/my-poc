package poc4.sim.a.service;

import poc4.sim.a.dto.ChangePinRequest;
import poc4.sim.a.dto.InternalUserStatus;
import poc4.sim.a.dto.PinChangeResult;
import poc4.sim.a.dto.UserPage;
import poc4.sim.a.dto.UserProfile;
import poc4.sim.a.dto.UserSummary;

public interface UserService {
    UserProfile profile(String userId);

    PinChangeResult changePin(String userId, ChangePinRequest request);

    UserPage search(String email, int page, int size);

    UserSummary unlock(String userId);

    InternalUserStatus internalStatus(String userId);
}

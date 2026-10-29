package poc4.sim.a.service;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import poc4.sim.a.dto.ChangePinRequest;
import poc4.sim.a.dto.InternalUserStatus;
import poc4.sim.a.dto.PinChangeResult;
import poc4.sim.a.dto.UserPage;
import poc4.sim.a.dto.UserProfile;
import poc4.sim.a.dto.UserSummary;
import poc4.sim.a.repository.UserRecord;
import poc4.sim.a.repository.UserRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.Digests;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.EventPublisher;

@Service
public class UserServiceImpl implements UserService {
    static final int MAX_PIN_ATTEMPTS = 5;

    private final UserRepository users;
    private final EventPublisher events;

    public UserServiceImpl(UserRepository users, EventPublisher events) {
        this.users = users;
        this.events = events;
    }

    @Override
    public UserProfile profile(String userId) {
        return UserProfile.of(require(userId));
    }

    @Override
    public PinChangeResult changePin(String userId, ChangePinRequest request) {
        UserRecord user = require(userId);
        if (user.locked) {
            throw new ApiException(ErrorCode.E206);
        }
        if (!hash(userId, request.currentPin).equals(user.pinHash)) {
            int attempts = user.failedPinAttempts + 1;
            boolean lock = attempts >= MAX_PIN_ATTEMPTS;
            users.recordPinFailure(userId, attempts, lock);
            if (lock) {
                throw new ApiException(ErrorCode.E206, "currentPin",
                        "The PIN did not match " + MAX_PIN_ATTEMPTS + " times; the account is now locked");
            }
            throw new ApiException(ErrorCode.E204, "currentPin",
                    "The PIN does not match; " + (MAX_PIN_ATTEMPTS - attempts) + " attempts left");
        }
        if (request.newPin.equals(request.currentPin)) {
            throw new ApiException(ErrorCode.E200, "newPin", "must differ from the current PIN");
        }
        users.updatePin(userId, hash(userId, request.newPin));
        events.publish("user-events", "user.pin-changed", Map.of("userId", userId));
        return new PinChangeResult(OffsetDateTime.now());
    }

    @Override
    public UserPage search(String email, int page, int size) {
        UserPage result = new UserPage();
        result.items = users.search(email, size, page * size).stream().map(UserSummary::of).collect(Collectors.toList());
        result.page = page;
        result.size = size;
        result.total = users.count(email);
        return result;
    }

    @Override
    public UserSummary unlock(String userId) {
        require(userId);
        users.unlock(userId);
        return UserSummary.of(users.findById(userId));
    }

    @Override
    public InternalUserStatus internalStatus(String userId) {
        return new InternalUserStatus(userId, require(userId).locked);
    }

    private UserRecord require(String userId) {
        UserRecord user = users.findById(userId);
        if (user == null) {
            throw new ApiException(ErrorCode.E243, "userId", "The user was not found");
        }
        return user;
    }

    static String hash(String userId, String pin) {
        return Digests.sha256(userId + ":" + pin);
    }
}

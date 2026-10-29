package poc4.sim.a.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import poc4.sim.a.dto.ChangePinRequest;
import poc4.sim.a.repository.UserRecord;
import poc4.sim.a.repository.UserRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.Digests;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.EventPublisher;

/**
 * Unit tests of the PIN rules in {@link UserServiceImpl}, in the style the real project already uses.
 */
@ExtendWith(MockitoExtension.class)
class UserServiceImplTest {
    private static final String USER = "auth0|unit-user";

    @Mock
    private UserRepository users;
    @Mock
    private EventPublisher events;
    @InjectMocks
    private UserServiceImpl service;

    private UserRecord user;

    @BeforeEach
    void setUp() {
        user = new UserRecord();
        user.userId = USER;
        user.pinHash = Digests.sha256(USER + ":246810");
        when(users.findById(USER)).thenReturn(user);
    }

    /**
     * A wrong PIN is counted and the error says how many attempts are left.
     */
    @Test
    void wrongPinCountsAttempt() {
        user.failedPinAttempts = 2;
        assertThatThrownBy(() -> service.changePin(USER, request("135790", "246813")))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.E204);
                    assertThat(e.getMessage()).contains("2 attempts left");
                });
        verify(users).recordPinFailure(USER, 3, false);
    }

    /**
     * The fifth wrong PIN locks the account.
     */
    @Test
    void fifthWrongPinLocks() {
        user.failedPinAttempts = 4;
        assertThatThrownBy(() -> service.changePin(USER, request("135790", "246813")))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.E206));
        verify(users).recordPinFailure(USER, 5, true);
    }

    /**
     * The right PIN stores the new hash and publishes an event.
     */
    @Test
    void correctPinChanges() {
        service.changePin(USER, request("246810", "246813"));
        verify(users).updatePin(USER, Digests.sha256(USER + ":246813"));
        verify(events).publish(eq("user-events"), eq("user.pin-changed"), anyMap());
    }

    /**
     * A locked account is refused before the PIN is checked.
     */
    @Test
    void lockedAccountRefused() {
        user.locked = true;
        assertThatThrownBy(() -> service.changePin(USER, request("246810", "246813")))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.E206));
        verify(users, never()).updatePin(anyString(), any());
    }

    private static ChangePinRequest request(String current, String next) {
        ChangePinRequest r = new ChangePinRequest();
        r.currentPin = current;
        r.newPin = next;
        return r;
    }
}

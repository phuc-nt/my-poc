package poc4.sim.a.controller;

import java.util.List;
import javax.validation.Valid;
import javax.validation.constraints.Pattern;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.a.dto.ChangePinRequest;
import poc4.sim.a.dto.Consent;
import poc4.sim.a.dto.ConsentRequest;
import poc4.sim.a.dto.ConsentType;
import poc4.sim.a.dto.Device;
import poc4.sim.a.dto.PinChangeResult;
import poc4.sim.a.dto.RegisterDeviceRequest;
import poc4.sim.a.dto.UserProfile;
import poc4.sim.a.service.ConsentService;
import poc4.sim.a.service.DeviceService;
import poc4.sim.a.service.UserService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.UserId;

/** The mobile app's endpoints. A user reaches only their own id (see OwnerGuard). */
@RestController
@Validated
@RequestMapping("/app/v1/users/{userId}")
public class AppUserController {
    private final UserService users;
    private final DeviceService devices;
    private final ConsentService consents;

    public AppUserController(UserService users, DeviceService devices, ConsentService consents) {
        this.users = users;
        this.devices = devices;
        this.consents = consents;
    }

    @GetMapping
    public ResponseEntity<RestApiResponse<UserProfile>> profile(@PathVariable @UserId String userId) {
        return Responses.ok(users.profile(userId));
    }

    @PutMapping("/pin")
    public ResponseEntity<RestApiResponse<PinChangeResult>> changePin(@PathVariable @UserId String userId,
                                                                      @RequestBody @Valid ChangePinRequest request) {
        return Responses.ok(users.changePin(userId, request));
    }

    @GetMapping("/devices")
    public ResponseEntity<RestApiResponse<List<Device>>> devices(@PathVariable @UserId String userId) {
        return Responses.ok(devices.list(userId));
    }

    @PostMapping("/devices")
    public ResponseEntity<RestApiResponse<Device>> registerDevice(@PathVariable @UserId String userId,
                                                                  @RequestBody @Valid RegisterDeviceRequest request) {
        return Responses.created(devices.register(userId, request));
    }

    @DeleteMapping("/devices/{deviceId}")
    public ResponseEntity<RestApiResponse<Void>> removeDevice(
            @PathVariable @UserId String userId,
            @PathVariable @Pattern(regexp = "^[0-9a-f-]{36}$", message = "must be a device id") String deviceId) {
        devices.remove(userId, deviceId);
        return Responses.ok(null);
    }

    @GetMapping("/consents")
    public ResponseEntity<RestApiResponse<List<Consent>>> consents(@PathVariable @UserId String userId) {
        return Responses.ok(consents.list(userId));
    }

    @PutMapping("/consents/{consentType}")
    public ResponseEntity<RestApiResponse<Consent>> putConsent(@PathVariable @UserId String userId,
                                                               @PathVariable ConsentType consentType,
                                                               @RequestBody @Valid ConsentRequest request) {
        return Responses.ok(consents.put(userId, consentType, request));
    }
}

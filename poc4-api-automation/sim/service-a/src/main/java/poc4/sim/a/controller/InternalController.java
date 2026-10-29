package poc4.sim.a.controller;

import javax.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.a.dto.InternalUserStatus;
import poc4.sim.a.dto.PushRequest;
import poc4.sim.a.dto.PushResult;
import poc4.sim.a.service.NotificationService;
import poc4.sim.a.service.UserService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.UserId;

/** Endpoints for other services, called with an API key. */
@RestController
@Validated
@RequestMapping("/internal/v1/users/{userId}")
public class InternalController {
    private final UserService users;
    private final NotificationService notifications;

    public InternalController(UserService users, NotificationService notifications) {
        this.users = users;
        this.notifications = notifications;
    }

    @GetMapping
    public ResponseEntity<RestApiResponse<InternalUserStatus>> status(@PathVariable @UserId String userId) {
        return Responses.ok(users.internalStatus(userId));
    }

    @PostMapping("/notifications")
    public ResponseEntity<RestApiResponse<PushResult>> push(@PathVariable @UserId String userId,
                                                            @RequestBody @Valid PushRequest request) {
        return Responses.ok(notifications.push(userId, request));
    }
}

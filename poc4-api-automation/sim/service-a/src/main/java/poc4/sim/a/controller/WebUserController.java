package poc4.sim.a.controller;

import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.a.dto.Consent;
import poc4.sim.a.dto.UserProfile;
import poc4.sim.a.service.ConsentService;
import poc4.sim.a.service.UserService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.UserId;

/** The web portal's endpoints. */
@RestController
@Validated
@RequestMapping("/web/v1/users/{userId}")
public class WebUserController {
    private final UserService users;
    private final ConsentService consents;

    public WebUserController(UserService users, ConsentService consents) {
        this.users = users;
        this.consents = consents;
    }

    @GetMapping
    public ResponseEntity<RestApiResponse<UserProfile>> profile(@PathVariable @UserId String userId) {
        return Responses.ok(users.profile(userId));
    }

    @GetMapping("/consents")
    public ResponseEntity<RestApiResponse<List<Consent>>> consents(@PathVariable @UserId String userId) {
        return Responses.ok(consents.list(userId));
    }
}

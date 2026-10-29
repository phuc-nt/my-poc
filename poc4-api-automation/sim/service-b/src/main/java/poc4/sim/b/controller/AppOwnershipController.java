package poc4.sim.b.controller;

import java.util.List;
import javax.validation.Valid;
import javax.validation.constraints.Pattern;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.b.dto.CreateOwnershipRequest;
import poc4.sim.b.dto.Ownership;
import poc4.sim.b.dto.Subscription;
import poc4.sim.b.dto.SubscriptionRequest;
import poc4.sim.b.service.OwnershipService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.UserId;

/** The mobile app's endpoints for a user's vehicles and their subscriptions. */
@RestController
@Validated
@RequestMapping("/app/v1/users/{userId}/ownerships")
public class AppOwnershipController {
    private static final String ID = "^[0-9a-f-]{36}$";

    private final OwnershipService ownerships;

    public AppOwnershipController(OwnershipService ownerships) {
        this.ownerships = ownerships;
    }

    @GetMapping
    public ResponseEntity<RestApiResponse<List<Ownership>>> list(@PathVariable @UserId String userId) {
        return Responses.ok(ownerships.list(userId));
    }

    @PostMapping
    public ResponseEntity<RestApiResponse<Ownership>> create(@PathVariable @UserId String userId,
                                                             @RequestBody @Valid CreateOwnershipRequest request) {
        return Responses.created(ownerships.create(userId, request));
    }

    @DeleteMapping("/{ownershipId}")
    public ResponseEntity<RestApiResponse<Ownership>> end(@PathVariable @UserId String userId,
                                                          @PathVariable @Pattern(regexp = ID, message = "must be an ownership id") String ownershipId) {
        return Responses.ok(ownerships.end(userId, ownershipId));
    }

    @GetMapping("/{ownershipId}/subscriptions")
    public ResponseEntity<RestApiResponse<List<Subscription>>> subscriptions(
            @PathVariable @UserId String userId,
            @PathVariable @Pattern(regexp = ID, message = "must be an ownership id") String ownershipId) {
        return Responses.ok(ownerships.subscriptions(userId, ownershipId));
    }

    @PostMapping("/{ownershipId}/subscriptions")
    public ResponseEntity<RestApiResponse<Subscription>> subscribe(
            @PathVariable @UserId String userId,
            @PathVariable @Pattern(regexp = ID, message = "must be an ownership id") String ownershipId,
            @RequestBody @Valid SubscriptionRequest request) {
        return Responses.created(ownerships.subscribe(userId, ownershipId, request));
    }
}

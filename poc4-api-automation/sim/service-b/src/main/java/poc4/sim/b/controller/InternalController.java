package poc4.sim.b.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.b.dto.VinOwner;
import poc4.sim.b.service.OwnershipService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.Vin;

/** Endpoints for other services, called with an API key. */
@RestController
@Validated
@RequestMapping("/internal/v1/vins/{vin}")
public class InternalController {
    private final OwnershipService ownerships;

    public InternalController(OwnershipService ownerships) {
        this.ownerships = ownerships;
    }

    @GetMapping("/owner")
    public ResponseEntity<RestApiResponse<VinOwner>> owner(@PathVariable @Vin String vin) {
        return Responses.ok(ownerships.owner(vin));
    }
}

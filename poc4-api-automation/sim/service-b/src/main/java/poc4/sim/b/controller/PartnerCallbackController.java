package poc4.sim.b.controller;

import javax.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.b.dto.SimStatusCallback;
import poc4.sim.b.dto.Tcu;
import poc4.sim.b.dto.VinCallback;
import poc4.sim.b.dto.VinRegistration;
import poc4.sim.b.service.TcuService;
import poc4.sim.b.service.VinRegistrationService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;

/** Callbacks from the registration workflow and the carrier, authenticated with the partner key. */
@RestController
@RequestMapping("/partner/v1/callbacks")
public class PartnerCallbackController {
    private final VinRegistrationService registrations;
    private final TcuService tcus;

    public PartnerCallbackController(VinRegistrationService registrations, TcuService tcus) {
        this.registrations = registrations;
        this.tcus = tcus;
    }

    @PostMapping("/vin-registration")
    public ResponseEntity<RestApiResponse<VinRegistration>> vinRegistration(@RequestBody @Valid VinCallback callback) {
        return Responses.ok(registrations.complete(callback));
    }

    @PostMapping("/sim-status")
    public ResponseEntity<RestApiResponse<Tcu>> simStatus(@RequestBody @Valid SimStatusCallback callback) {
        return Responses.ok(tcus.simStatus(callback));
    }
}

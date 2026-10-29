package poc4.sim.b.controller;

import javax.validation.Valid;
import javax.validation.constraints.Pattern;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.b.dto.Tcu;
import poc4.sim.b.dto.VinRegistration;
import poc4.sim.b.dto.VinRegistrationRequest;
import poc4.sim.b.service.TcuService;
import poc4.sim.b.service.VinRegistrationService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.Vin;

/** The back-office endpoints: VIN registration and SIM activation. */
@RestController
@Validated
@RequestMapping("/bo/v1")
public class BackOfficeController {
    private static final String TCU_ID = "^TCU-\\d{4}$";

    private final VinRegistrationService registrations;
    private final TcuService tcus;

    public BackOfficeController(VinRegistrationService registrations, TcuService tcus) {
        this.registrations = registrations;
        this.tcus = tcus;
    }

    @PostMapping("/vin-registrations")
    public ResponseEntity<RestApiResponse<VinRegistration>> register(@RequestBody @Valid VinRegistrationRequest request) {
        return Responses.accepted(registrations.register(request));
    }

    @GetMapping("/vin-registrations/{vin}")
    public ResponseEntity<RestApiResponse<VinRegistration>> registration(@PathVariable @Vin String vin) {
        return Responses.ok(registrations.status(vin));
    }

    @GetMapping("/tcus/{tcuId}")
    public ResponseEntity<RestApiResponse<Tcu>> tcu(@PathVariable @Pattern(regexp = TCU_ID, message = "must be a unit id such as TCU-0001") String tcuId) {
        return Responses.ok(tcus.get(tcuId));
    }

    @PostMapping("/tcus/{tcuId}/sim/activate")
    public ResponseEntity<RestApiResponse<Tcu>> activateSim(@PathVariable @Pattern(regexp = TCU_ID, message = "must be a unit id such as TCU-0001") String tcuId) {
        return Responses.accepted(tcus.activateSim(tcuId));
    }
}

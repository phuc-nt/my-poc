package poc4.sim.b.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.OffsetDateTime;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import poc4.sim.b.dto.CallbackResult;
import poc4.sim.b.dto.VinCallback;
import poc4.sim.b.dto.VinRegistration;
import poc4.sim.b.dto.VinRegistrationRequest;
import poc4.sim.b.repository.VinRegistrationRecord;
import poc4.sim.b.repository.VinRegistrationRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.DownstreamClient;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.EventPublisher;
import poc4.sim.common.SimProperties;

@Service
public class VinRegistrationServiceImpl implements VinRegistrationService {
    private final VinRegistrationRepository registrations;
    private final DownstreamClient client;
    private final EventPublisher events;
    private final SimProperties sim;

    public VinRegistrationServiceImpl(VinRegistrationRepository registrations, DownstreamClient client,
                                      EventPublisher events, SimProperties sim) {
        this.registrations = registrations;
        this.client = client;
        this.events = events;
        this.sim = sim;
    }

    @Override
    public VinRegistration register(VinRegistrationRequest request) {
        if (registrations.findByVin(request.vin) != null) {
            throw new ApiException(ErrorCode.E250, "vin", "The VIN has already been submitted");
        }
        ResponseEntity<JsonNode> started = client.call("workflow", HttpMethod.POST, sim.getThirdPartyUrl() + "/workflow/v1/executions",
                Map.of("stateMachine", "vin-registration", "input", Map.of("vin", request.vin, "modelCode", request.modelCode)), null);
        String executionId = started.getBody() == null ? "" : started.getBody().path("executionId").asText("");
        if (!started.getStatusCode().is2xxSuccessful() || executionId.isEmpty()) {
            throw new ApiException(ErrorCode.E611, null, "workflow did not start (" + started.getStatusCodeValue() + ")");
        }
        VinRegistrationRecord record = new VinRegistrationRecord();
        record.vin = request.vin;
        record.modelCode = request.modelCode;
        record.status = "REQUESTED";
        record.executionId = executionId;
        record.requestedAt = OffsetDateTime.now();
        record.updatedAt = record.requestedAt;
        registrations.insert(record);
        events.publish("vehicle-events", "vin.registration-requested", Map.of("vin", request.vin, "executionId", executionId));
        return VinRegistration.of(record);
    }

    @Override
    public VinRegistration status(String vin) {
        return VinRegistration.of(require(vin));
    }

    @Override
    public VinRegistration complete(VinCallback callback) {
        VinRegistrationRecord record = require(callback.vin);
        if (!record.executionId.equals(callback.executionId)) {
            throw new ApiException(ErrorCode.E243, "executionId", "No registration of this VIN has this execution id");
        }
        String target = callback.result == CallbackResult.SUCCEEDED ? "REGISTERED" : "REJECTED";
        if (!"REQUESTED".equals(record.status)) {
            if (target.equals(record.status)) {
                return VinRegistration.of(record);
            }
            throw new ApiException(ErrorCode.E250, "result", "The registration has already ended as " + record.status);
        }
        registrations.updateResult(callback.vin, target, callback.reason);
        events.publish("vehicle-events", "vin." + target.toLowerCase(), Map.of("vin", callback.vin));
        return VinRegistration.of(registrations.findByVin(callback.vin));
    }

    private VinRegistrationRecord require(String vin) {
        VinRegistrationRecord record = registrations.findByVin(vin);
        if (record == null) {
            throw new ApiException(ErrorCode.E243, "vin", "The VIN has not been submitted");
        }
        return record;
    }
}

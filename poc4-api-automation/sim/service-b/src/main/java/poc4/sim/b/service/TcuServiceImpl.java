package poc4.sim.b.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import poc4.sim.b.dto.SimStatusCallback;
import poc4.sim.b.dto.Tcu;
import poc4.sim.b.repository.TcuRecord;
import poc4.sim.b.repository.TcuRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.DownstreamClient;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.SimProperties;

@Service
public class TcuServiceImpl implements TcuService {
    private final TcuRepository tcus;
    private final DownstreamClient client;
    private final SimProperties sim;

    public TcuServiceImpl(TcuRepository tcus, DownstreamClient client, SimProperties sim) {
        this.tcus = tcus;
        this.client = client;
        this.sim = sim;
    }

    @Override
    public Tcu get(String tcuId) {
        return Tcu.of(require(tcuId));
    }

    @Override
    public Tcu activateSim(String tcuId) {
        TcuRecord tcu = require(tcuId);
        if ("ACTIVE".equals(tcu.simStatus) || "ACTIVATING".equals(tcu.simStatus)) {
            throw new ApiException(ErrorCode.E250, null, "The SIM is already " + tcu.simStatus);
        }
        ResponseEntity<JsonNode> order = client.call("telecom", HttpMethod.POST,
                sim.getThirdPartyUrl() + "/telecom/v1/sims/{iccid}/activation", Map.of("tcuId", tcuId), null, tcu.iccid);
        String orderId = order.getBody() == null ? "" : order.getBody().path("orderId").asText("");
        if (!order.getStatusCode().is2xxSuccessful() || orderId.isEmpty()) {
            throw new ApiException(ErrorCode.E611, null, "telecom answered " + order.getStatusCodeValue());
        }
        tcus.updateSim(tcuId, "ACTIVATING", orderId);
        return Tcu.of(tcus.findById(tcuId));
    }

    @Override
    public Tcu simStatus(SimStatusCallback callback) {
        TcuRecord tcu = tcus.findByIccid(callback.iccid);
        if (tcu == null) {
            throw new ApiException(ErrorCode.E243, "iccid", "No unit has this SIM");
        }
        tcus.updateSim(tcu.tcuId, callback.status.name(), null);
        return Tcu.of(tcus.findById(tcu.tcuId));
    }

    private TcuRecord require(String tcuId) {
        TcuRecord tcu = tcus.findById(tcuId);
        if (tcu == null) {
            throw new ApiException(ErrorCode.E243, "tcuId", "The unit was not found");
        }
        return tcu;
    }
}

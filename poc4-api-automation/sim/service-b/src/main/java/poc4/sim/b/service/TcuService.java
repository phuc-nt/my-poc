package poc4.sim.b.service;

import poc4.sim.b.dto.SimStatusCallback;
import poc4.sim.b.dto.Tcu;

public interface TcuService {
    Tcu get(String tcuId);

    /** Orders SIM activation from the carrier; the result arrives later by callback. */
    Tcu activateSim(String tcuId);

    Tcu simStatus(SimStatusCallback callback);
}

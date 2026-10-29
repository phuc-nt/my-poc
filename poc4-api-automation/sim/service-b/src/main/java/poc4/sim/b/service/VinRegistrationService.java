package poc4.sim.b.service;

import poc4.sim.b.dto.VinCallback;
import poc4.sim.b.dto.VinRegistration;
import poc4.sim.b.dto.VinRegistrationRequest;

public interface VinRegistrationService {
    /** Starts the registration workflow and returns at once with status REQUESTED. */
    VinRegistration register(VinRegistrationRequest request);

    VinRegistration status(String vin);

    /** Records the workflow's result. A repeated callback with the same result changes nothing. */
    VinRegistration complete(VinCallback callback);
}

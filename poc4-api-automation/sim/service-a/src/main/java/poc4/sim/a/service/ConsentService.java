package poc4.sim.a.service;

import java.util.List;
import poc4.sim.a.dto.Consent;
import poc4.sim.a.dto.ConsentRequest;
import poc4.sim.a.dto.ConsentType;

public interface ConsentService {
    List<Consent> list(String userId);

    Consent put(String userId, ConsentType type, ConsentRequest request);
}

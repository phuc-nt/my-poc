package poc4.sim.a.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import poc4.sim.a.dto.Consent;
import poc4.sim.a.dto.ConsentRequest;
import poc4.sim.a.dto.ConsentType;
import poc4.sim.a.repository.ConsentRecord;
import poc4.sim.a.repository.ConsentRepository;
import poc4.sim.a.repository.UserRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.EventPublisher;

@Service
public class ConsentServiceImpl implements ConsentService {
    private final ConsentRepository consents;
    private final UserRepository users;
    private final EventPublisher events;

    public ConsentServiceImpl(ConsentRepository consents, UserRepository users, EventPublisher events) {
        this.consents = consents;
        this.users = users;
        this.events = events;
    }

    @Override
    public List<Consent> list(String userId) {
        return consents.findByUser(userId).stream().map(Consent::of).collect(Collectors.toList());
    }

    @Override
    public Consent put(String userId, ConsentType type, ConsentRequest request) {
        if (users.findById(userId) == null) {
            throw new ApiException(ErrorCode.E243, "userId", "The user was not found");
        }
        ConsentRecord record = new ConsentRecord();
        record.userId = userId;
        record.consentType = type.name();
        record.version = request.version;
        record.agreed = request.agreed;
        record.updatedAt = OffsetDateTime.now();
        consents.upsert(record);
        events.publish("privacy-events", "consent.updated",
                Map.of("userId", userId, "consentType", type.name(), "version", request.version, "agreed", request.agreed));
        return Consent.of(record);
    }
}

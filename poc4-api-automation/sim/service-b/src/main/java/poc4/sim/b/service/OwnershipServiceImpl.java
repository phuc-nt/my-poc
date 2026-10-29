package poc4.sim.b.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import poc4.sim.b.dto.CreateOwnershipRequest;
import poc4.sim.b.dto.Ownership;
import poc4.sim.b.dto.Subscription;
import poc4.sim.b.dto.SubscriptionRequest;
import poc4.sim.b.dto.VinOwner;
import poc4.sim.b.repository.OwnershipRecord;
import poc4.sim.b.repository.OwnershipRepository;
import poc4.sim.b.repository.SubscriptionRecord;
import poc4.sim.b.repository.SubscriptionRepository;
import poc4.sim.b.repository.VinRegistrationRecord;
import poc4.sim.b.repository.VinRegistrationRepository;
import poc4.sim.common.ApiException;
import poc4.sim.common.DownstreamClient;
import poc4.sim.common.ErrorCode;
import poc4.sim.common.EventPublisher;
import poc4.sim.common.SimProperties;

@Service
public class OwnershipServiceImpl implements OwnershipService {
    private final OwnershipRepository ownerships;
    private final SubscriptionRepository subscriptions;
    private final VinRegistrationRepository registrations;
    private final ServiceAClient serviceA;
    private final DownstreamClient client;
    private final EventPublisher events;
    private final SimProperties sim;

    public OwnershipServiceImpl(OwnershipRepository ownerships, SubscriptionRepository subscriptions,
                                VinRegistrationRepository registrations, ServiceAClient serviceA,
                                DownstreamClient client, EventPublisher events, SimProperties sim) {
        this.ownerships = ownerships;
        this.subscriptions = subscriptions;
        this.registrations = registrations;
        this.serviceA = serviceA;
        this.client = client;
        this.events = events;
        this.sim = sim;
    }

    @Override
    public List<Ownership> list(String userId) {
        return ownerships.findByUser(userId).stream().map(Ownership::of).collect(Collectors.toList());
    }

    @Override
    public Ownership create(String userId, CreateOwnershipRequest request) {
        serviceA.requireActiveUser(userId);
        VinRegistrationRecord registration = registrations.findByVin(request.vin);
        if (registration == null || !"REGISTERED".equals(registration.status)) {
            throw new ApiException(ErrorCode.E243, "vin", "The VIN is not registered");
        }
        if (ownerships.findActiveByVin(request.vin) != null) {
            throw new ApiException(ErrorCode.E250, "vin", "The vehicle already has an owner");
        }
        OwnershipRecord record = new OwnershipRecord();
        record.ownershipId = UUID.randomUUID().toString();
        record.userId = userId;
        record.vin = request.vin;
        record.nickname = request.nickname;
        record.status = "ACTIVE";
        record.createdAt = OffsetDateTime.now();
        ownerships.insert(record);
        events.publish("vehicle-events", "ownership.created",
                Map.of("ownershipId", record.ownershipId, "userId", userId, "vin", request.vin));
        return Ownership.of(record);
    }

    @Override
    public Ownership end(String userId, String ownershipId) {
        OwnershipRecord record = requireActive(userId, ownershipId);
        ownerships.end(ownershipId);
        events.publish("vehicle-events", "ownership.ended", Map.of("ownershipId", ownershipId, "vin", record.vin));
        return Ownership.of(ownerships.findById(ownershipId));
    }

    @Override
    public List<Subscription> subscriptions(String userId, String ownershipId) {
        OwnershipRecord record = ownerships.findById(ownershipId);
        if (record == null || !record.userId.equals(userId)) {
            throw new ApiException(ErrorCode.E243, "ownershipId", "The ownership was not found");
        }
        return subscriptions.findByOwnership(ownershipId).stream().map(Subscription::of).collect(Collectors.toList());
    }

    @Override
    public Subscription subscribe(String userId, String ownershipId, SubscriptionRequest request) {
        requireActive(userId, ownershipId);
        if (subscriptions.countActive(ownershipId) > 0) {
            throw new ApiException(ErrorCode.E250, null, "The vehicle already has an active subscription");
        }
        ResponseEntity<JsonNode> charge = client.call("payment", HttpMethod.POST, sim.getThirdPartyUrl() + "/payment/v1/charges",
                Map.of("customerRef", userId, "amount", request.plan.getPrice(), "currency", "JPY",
                        "description", request.plan.name() + " plan"), null);
        if (charge.getStatusCode() == HttpStatus.PAYMENT_REQUIRED) {
            throw new ApiException(ErrorCode.E610);
        }
        String chargeId = charge.getBody() == null ? "" : charge.getBody().path("chargeId").asText("");
        if (!charge.getStatusCode().is2xxSuccessful() || chargeId.isEmpty()) {
            throw new ApiException(ErrorCode.E611, null, "payment answered " + charge.getStatusCodeValue());
        }
        SubscriptionRecord record = new SubscriptionRecord();
        record.subscriptionId = UUID.randomUUID().toString();
        record.ownershipId = ownershipId;
        record.plan = request.plan.name();
        record.status = "ACTIVE";
        record.paymentRef = chargeId;
        record.startedAt = OffsetDateTime.now();
        subscriptions.insert(record);
        events.publish("billing-events", "subscription.started",
                Map.of("subscriptionId", record.subscriptionId, "ownershipId", ownershipId, "plan", record.plan));
        return Subscription.of(record);
    }

    @Override
    public VinOwner owner(String vin) {
        OwnershipRecord record = ownerships.findActiveByVin(vin);
        if (record == null) {
            throw new ApiException(ErrorCode.E243, "vin", "The vehicle has no owner");
        }
        return new VinOwner(vin, record.userId, record.ownershipId);
    }

    private OwnershipRecord requireActive(String userId, String ownershipId) {
        OwnershipRecord record = ownerships.findById(ownershipId);
        if (record == null || !record.userId.equals(userId) || !"ACTIVE".equals(record.status)) {
            throw new ApiException(ErrorCode.E243, "ownershipId", "No active ownership with this id");
        }
        return record;
    }
}

package poc4.sim.b.service;

import java.util.List;
import poc4.sim.b.dto.CreateOwnershipRequest;
import poc4.sim.b.dto.Ownership;
import poc4.sim.b.dto.Subscription;
import poc4.sim.b.dto.SubscriptionRequest;
import poc4.sim.b.dto.VinOwner;

public interface OwnershipService {
    List<Ownership> list(String userId);

    Ownership create(String userId, CreateOwnershipRequest request);

    Ownership end(String userId, String ownershipId);

    List<Subscription> subscriptions(String userId, String ownershipId);

    /** Charges the plan's price through the payment provider, then starts the subscription. */
    Subscription subscribe(String userId, String ownershipId, SubscriptionRequest request);

    VinOwner owner(String vin);
}

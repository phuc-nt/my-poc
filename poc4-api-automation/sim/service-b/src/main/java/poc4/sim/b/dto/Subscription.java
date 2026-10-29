package poc4.sim.b.dto;

import java.time.OffsetDateTime;
import poc4.sim.b.repository.SubscriptionRecord;

public class Subscription {
    public String subscriptionId;
    public String ownershipId;
    public Plan plan;
    public String status;
    public String paymentRef;
    public OffsetDateTime startedAt;

    public static Subscription of(SubscriptionRecord r) {
        Subscription s = new Subscription();
        s.subscriptionId = r.subscriptionId;
        s.ownershipId = r.ownershipId;
        s.plan = Plan.valueOf(r.plan);
        s.status = r.status;
        s.paymentRef = r.paymentRef;
        s.startedAt = r.startedAt;
        return s;
    }
}

package poc4.sim.b.dto;

import javax.validation.constraints.NotNull;

public class SubscriptionRequest {
    @NotNull
    public Plan plan;
}

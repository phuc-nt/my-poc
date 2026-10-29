package poc4.sim.b.dto;

import javax.validation.constraints.NotNull;
import javax.validation.constraints.Size;
import poc4.sim.common.validation.Vin;

public class CreateOwnershipRequest {
    @NotNull
    @Vin
    public String vin;
    @Size(max = 32)
    public String nickname;
}

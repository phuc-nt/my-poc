package poc4.sim.a.dto;

import javax.validation.constraints.NotNull;
import poc4.sim.common.validation.Pin;

public class ChangePinRequest {
    @NotNull
    @Pin
    public String currentPin;
    @NotNull
    @Pin
    public String newPin;
}

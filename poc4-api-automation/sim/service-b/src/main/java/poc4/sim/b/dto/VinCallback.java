package poc4.sim.b.dto;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Size;
import poc4.sim.common.validation.Vin;

/** What the registration workflow sends back when it finishes. */
public class VinCallback {
    @NotBlank
    @Size(max = 80)
    public String executionId;
    @NotNull
    @Vin
    public String vin;
    @NotNull
    public CallbackResult result;
    @Size(max = 200)
    public String reason;
}

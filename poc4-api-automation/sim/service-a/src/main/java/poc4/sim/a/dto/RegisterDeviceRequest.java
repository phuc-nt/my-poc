package poc4.sim.a.dto;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Size;

public class RegisterDeviceRequest {
    @NotNull
    public Platform platform;
    @NotBlank
    @Size(max = 256)
    public String pushToken;
}

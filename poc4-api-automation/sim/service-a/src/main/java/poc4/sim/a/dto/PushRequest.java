package poc4.sim.a.dto;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.Size;

public class PushRequest {
    @NotBlank
    @Size(max = 64)
    public String title;
    @NotBlank
    @Size(max = 256)
    public String body;
}

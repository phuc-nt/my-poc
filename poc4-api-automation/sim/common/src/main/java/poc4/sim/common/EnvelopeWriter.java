package poc4.sim.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.List;
import javax.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

/** Writes an NG envelope from a servlet filter, where the controller advice does not reach. */
@Component
public class EnvelopeWriter {
    private final ObjectMapper mapper;

    public EnvelopeWriter(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public void write(HttpServletResponse response, ErrorCode code, String field, String message) throws IOException {
        RestApiResponse<Void> body = RestApiResponse.ng(List.of(new ApiError(code, field, message)));
        HttpHeaders headers = new HttpHeaders();
        ResultHeaders.apply(headers, body);
        headers.forEach((name, values) -> response.setHeader(name, values.get(0)));
        response.setStatus(code.getStatus().value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        mapper.writeValue(response.getOutputStream(), body);
    }
}

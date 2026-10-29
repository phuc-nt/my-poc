package poc4.sim.common;

import java.io.IOException;
import java.time.Instant;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Reads X-One-Time-Uuid and echoes it in X_ONE_TIME_UUID with X_EVENT_TIME, before security runs, so that every
 * answer carries them, a 401 included. A missing id is generated; an id that is not a UUID is refused with E200.
 */
public class CorrelationFilter extends OncePerRequestFilter {
    private static final Pattern UUID_FORMAT =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    private final EnvelopeWriter writer;

    public CorrelationFilter(EnvelopeWriter writer) {
        this.writer = writer;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String id = request.getHeader(ResultHeaders.REQUEST_UUID);
        boolean invalid = id != null && !UUID_FORMAT.matcher(id).matches();
        if (id == null || invalid) {
            id = UUID.randomUUID().toString();
        }
        response.setHeader(ResultHeaders.ONE_TIME_UUID, id);
        response.setHeader(ResultHeaders.EVENT_TIME, Instant.now().toString());
        if (invalid) {
            writer.write(response, ErrorCode.E200, ResultHeaders.REQUEST_UUID, "X-One-Time-Uuid must be a UUID");
            return;
        }
        Correlation.set(id);
        try {
            chain.doFilter(request, response);
        } finally {
            Correlation.clear();
        }
    }
}

package poc4.sim.common;

import java.io.IOException;
import java.util.List;
import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** Authenticates service-to-service calls (X-Api-Key on /internal) and partner callbacks (X-Partner-Key on /partner). */
public class ApiKeyFilter extends OncePerRequestFilter {
    private final SimProperties props;

    public ApiKeyFilter(SimProperties props) {
        this.props = props;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (path.startsWith("/internal/") && matches(request.getHeader("X-Api-Key"), props.getInternalApiKey())) {
            authenticate("internal", "ROLE_INTERNAL");
        } else if (path.startsWith("/partner/") && matches(request.getHeader("X-Partner-Key"), props.getPartnerApiKey())) {
            authenticate("partner", "ROLE_PARTNER");
        }
        chain.doFilter(request, response);
    }

    private static boolean matches(String given, String expected) {
        return given != null && expected != null && !expected.isEmpty()
                && Digests.equal(given, expected);
    }

    private static void authenticate(String principal, String role) {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(principal, null, List.of(new SimpleGrantedAuthority(role))));
    }
}

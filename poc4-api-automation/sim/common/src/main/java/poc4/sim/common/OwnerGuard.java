package poc4.sim.common;

import java.util.Map;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;

/** On /app and /web, a user may only reach paths under their own user id (the JWT subject). */
public class OwnerGuard implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (!path.startsWith("/app/") && !path.startsWith("/web/")) {
            return true;
        }
        @SuppressWarnings("unchecked")
        Map<String, String> variables = (Map<String, String>) request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        if (variables == null || !variables.containsKey("userId")) {
            return true;
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !variables.get("userId").equals(auth.getName())) {
            throw new ApiException(ErrorCode.E102, "userId", "A user may only reach their own resources");
        }
        return true;
    }
}

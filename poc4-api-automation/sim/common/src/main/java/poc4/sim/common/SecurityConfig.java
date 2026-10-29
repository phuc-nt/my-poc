package poc4.sim.common;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.web.BearerTokenAuthenticationFilter;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;

/**
 * Access per caller group: a user JWT (scope user) on /app and /web, a back-office JWT (scope backoffice) on /bo, an
 * API key on /internal, a partner key on /partner. Where this lives in the real services (library or gateway) is unknown.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, SimProperties props, EnvelopeWriter writer) throws Exception {
        AuthenticationEntryPoint unauthenticated = (request, response, e) -> writer.write(response, ErrorCode.E101, null, null);
        AccessDeniedHandler denied = (request, response, e) -> writer.write(response, ErrorCode.E102, null, null);
        http.csrf().disable()
                .sessionManagement().sessionCreationPolicy(SessionCreationPolicy.STATELESS).and()
                .addFilterBefore(new ApiKeyFilter(props), BearerTokenAuthenticationFilter.class)
                .authorizeHttpRequests(auth -> auth
                        .antMatchers("/health", "/v3/api-docs/**", "/files/**").permitAll()
                        .antMatchers("/internal/**").hasRole("INTERNAL")
                        .antMatchers("/partner/**").hasRole("PARTNER")
                        .antMatchers("/bo/**").hasAuthority("SCOPE_backoffice")
                        .antMatchers("/app/**", "/web/**").hasAuthority("SCOPE_user")
                        .anyRequest().denyAll())
                .oauth2ResourceServer(oauth -> oauth.jwt().and()
                        .authenticationEntryPoint(unauthenticated).accessDeniedHandler(denied))
                .exceptionHandling(e -> e.authenticationEntryPoint(unauthenticated).accessDeniedHandler(denied));
        return http.build();
    }
}

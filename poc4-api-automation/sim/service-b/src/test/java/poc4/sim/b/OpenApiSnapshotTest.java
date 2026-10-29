package poc4.sim.b;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Writes the service's OpenAPI document to target/openapi/service-b.json during the unit test run.
 *
 * <p>The context starts on an in-memory H2 database with no schema, so no AWS, database or network is needed:
 * springdoc only reads the controllers and DTOs. The API tests compare this file with their committed contract.
 *
 * @see <a href="../../../../../../../tests/contracts">tests/contracts</a>
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:openapi;MODE=PostgreSQL",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "springdoc.api-docs.enabled=true"})
@AutoConfigureMockMvc
class OpenApiSnapshotTest {
    @Autowired
    private MockMvc mvc;

    /**
     * Fetches /v3/api-docs through MockMvc and saves it.
     *
     * @throws Exception when the request or the write fails
     */
    @Test
    void writesOpenApiDocument() throws Exception {
        String json = mvc.perform(get("/v3/api-docs")).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        Path out = Path.of("target", "openapi", "service-b.json");
        Files.createDirectories(out.getParent());
        Files.writeString(out, json);
    }
}

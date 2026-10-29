package poc4.sim.a.repository;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.boot.test.autoconfigure.MybatisTest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.MountableFile;

/**
 * Runs the MyBatis SQL against a real PostgreSQL with the same init script as the simulated environment.
 *
 * <p>These are the statements H2 cannot judge: FOR UPDATE SKIP LOCKED, ON CONFLICT and date arithmetic.
 * Run with {@code mvn verify}; it needs Docker and nothing else.
 */
@MybatisTest
@Testcontainers
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class ExportRepositoryIT {
    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:16-alpine")
            .withUsername("sim").withPassword("local-only-db-password")
            .withCopyFileToContainer(MountableFile.forHostPath("../db/init.sql"), "/docker-entrypoint-initdb.d/init.sql");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",
                () -> DB.getJdbcUrl().replace("/" + DB.getDatabaseName(), "/service_a"));
        registry.add("spring.datasource.username", DB::getUsername);
        registry.add("spring.datasource.password", DB::getPassword);
    }

    @Autowired
    private ExportRepository exports;
    @Autowired
    private UserRepository users;
    @Autowired
    private ConsentRepository consents;

    /**
     * The date range includes the whole last day: seed users are created at 03:00 UTC each week.
     */
    @Test
    void dateRangeIncludesLastDay() {
        List<UserRecord> march = users.findCreatedBetween(LocalDate.of(2026, 3, 1), LocalDate.of(2026, 3, 26));
        assertThat(march).extracting(u -> u.userId)
                .containsExactly("auth0|seed-010", "auth0|seed-011", "auth0|seed-012", "auth0|seed-013");
    }

    /**
     * Two workers claiming at once never get the same job.
     */
    @Test
    void claimNextNeverHandsOutTheSameJob() {
        OffsetDateTime old = OffsetDateTime.now().minusMinutes(1);
        for (int i = 0; i < 6; i++) {
            ExportRecord job = new ExportRecord();
            job.requestId = UUID.randomUUID().toString();
            job.kind = "USERS";
            job.dateFrom = LocalDate.of(2026, 1, 1);
            job.dateTo = LocalDate.of(2026, 1, 2);
            job.status = "QUEUED";
            job.baseUrl = "http://localhost";
            job.requestedAt = old;
            exports.insert(job);
        }
        List<CompletableFuture<ExportRecord>> claims = List.of(1, 2, 3, 4, 5, 6).stream()
                .map(i -> CompletableFuture.supplyAsync(() -> exports.claimNext(OffsetDateTime.now())))
                .collect(java.util.stream.Collectors.toList());
        List<String> ids = claims.stream().map(CompletableFuture::join).filter(java.util.Objects::nonNull)
                .map(r -> r.requestId).collect(java.util.stream.Collectors.toList());
        assertThat(ids).doesNotHaveDuplicates().hasSize(6);
    }

    /**
     * Saving a consent twice keeps one row with the latest values.
     */
    @Test
    void consentUpsertKeepsOneRow() {
        ConsentRecord c = new ConsentRecord();
        c.userId = "auth0|seed-050";
        c.consentType = "MARKETING";
        c.version = "1.0";
        c.agreed = true;
        c.updatedAt = OffsetDateTime.now();
        consents.upsert(c);
        c.version = "2.0";
        c.agreed = false;
        consents.upsert(c);
        assertThat(consents.findByUser("auth0|seed-050")).filteredOn(r -> r.consentType.equals("MARKETING"))
                .singleElement().satisfies(r -> {
                    assertThat(r.version).isEqualTo("2.0");
                    assertThat(r.agreed).isFalse();
                });
    }
}

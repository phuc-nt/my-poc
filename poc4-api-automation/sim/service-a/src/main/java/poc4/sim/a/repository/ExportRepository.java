package poc4.sim.a.repository;

import java.time.OffsetDateTime;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface ExportRepository {
    void insert(ExportRecord export);

    ExportRecord findById(@Param("requestId") String requestId);

    /** Takes the oldest queued request made before notBefore and marks it PROCESSING, or returns null. */
    ExportRecord claimNext(@Param("notBefore") OffsetDateTime notBefore);

    void complete(@Param("requestId") String requestId, @Param("status") String status,
                  @Param("rowCount") Integer rowCount, @Param("fileName") String fileName);
}

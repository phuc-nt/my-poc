package poc4.sim.b.repository;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface VinRegistrationRepository {
    VinRegistrationRecord findByVin(@Param("vin") String vin);

    void insert(VinRegistrationRecord registration);

    void updateResult(@Param("vin") String vin, @Param("status") String status, @Param("reason") String reason);
}

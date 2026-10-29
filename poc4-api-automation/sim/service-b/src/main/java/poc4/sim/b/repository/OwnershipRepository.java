package poc4.sim.b.repository;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface OwnershipRepository {
    List<OwnershipRecord> findByUser(@Param("userId") String userId);

    OwnershipRecord findById(@Param("ownershipId") String ownershipId);

    OwnershipRecord findActiveByVin(@Param("vin") String vin);

    void insert(OwnershipRecord ownership);

    void end(@Param("ownershipId") String ownershipId);
}

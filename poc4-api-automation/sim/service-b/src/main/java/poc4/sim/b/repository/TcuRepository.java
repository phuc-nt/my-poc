package poc4.sim.b.repository;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface TcuRepository {
    TcuRecord findById(@Param("tcuId") String tcuId);

    TcuRecord findByIccid(@Param("iccid") String iccid);

    void updateSim(@Param("tcuId") String tcuId, @Param("simStatus") String simStatus, @Param("orderId") String orderId);
}

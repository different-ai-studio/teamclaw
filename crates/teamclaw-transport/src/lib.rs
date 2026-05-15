#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MqttBroker {
    pub host: String,
    pub port: u16,
    pub use_tls: bool,
}

impl MqttBroker {
    pub fn parse(url: &str) -> Self {
        let use_tls = url.starts_with("mqtts://");
        let default_port = if use_tls { 8883 } else { 1883 };
        let host_port = url
            .trim_start_matches("mqtts://")
            .trim_start_matches("mqtt://");

        let (host, port) = if let Some((host, port)) = host_port.split_once(':') {
            (
                host.to_string(),
                port.parse::<u16>().unwrap_or(default_port),
            )
        } else {
            (host_port.to_string(), default_port)
        };

        Self {
            host,
            port,
            use_tls,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryGuarantee {
    AtMostOnce,
    AtLeastOnce,
    ExactlyOnce,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
    pub delivery: DeliveryGuarantee,
}

pub trait Transport {
    type Error;

    fn publish(
        &self,
        message: TransportMessage,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send;

    fn subscribe(
        &self,
        topic: String,
        delivery: DeliveryGuarantee,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send;
}

impl From<DeliveryGuarantee> for rumqttc::QoS {
    fn from(value: DeliveryGuarantee) -> Self {
        match value {
            DeliveryGuarantee::AtMostOnce => rumqttc::QoS::AtMostOnce,
            DeliveryGuarantee::AtLeastOnce => rumqttc::QoS::AtLeastOnce,
            DeliveryGuarantee::ExactlyOnce => rumqttc::QoS::ExactlyOnce,
        }
    }
}

impl Transport for rumqttc::AsyncClient {
    type Error = rumqttc::ClientError;

    async fn publish(&self, message: TransportMessage) -> Result<(), Self::Error> {
        self.publish(
            message.topic,
            rumqttc::QoS::from(message.delivery),
            message.retain,
            message.payload,
        )
        .await
    }

    async fn subscribe(
        &self,
        topic: String,
        delivery: DeliveryGuarantee,
    ) -> Result<(), Self::Error> {
        self.subscribe(topic, rumqttc::QoS::from(delivery)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mqtt_broker_url_parses_plain_host_and_port() {
        let broker = MqttBroker::parse("mqtt://broker.local:1884");
        assert_eq!(broker.host, "broker.local");
        assert_eq!(broker.port, 1884);
        assert!(!broker.use_tls);
    }

    #[test]
    fn mqtt_broker_url_defaults_ports_by_scheme() {
        let plain = MqttBroker::parse("mqtt://broker.local");
        assert_eq!(plain.port, 1883);
        assert!(!plain.use_tls);

        let tls = MqttBroker::parse("mqtts://broker.local");
        assert_eq!(tls.port, 8883);
        assert!(tls.use_tls);
    }

    #[test]
    fn mqtt_broker_url_matches_legacy_fallback_for_invalid_port() {
        let broker = MqttBroker::parse("mqtts://broker.local:not-a-port");
        assert_eq!(broker.host, "broker.local");
        assert_eq!(broker.port, 8883);
        assert!(broker.use_tls);
    }

    #[test]
    fn delivery_guarantee_maps_to_rumqttc_qos() {
        assert_eq!(
            rumqttc::QoS::AtMostOnce,
            rumqttc::QoS::from(DeliveryGuarantee::AtMostOnce)
        );
        assert_eq!(
            rumqttc::QoS::AtLeastOnce,
            rumqttc::QoS::from(DeliveryGuarantee::AtLeastOnce)
        );
        assert_eq!(
            rumqttc::QoS::ExactlyOnce,
            rumqttc::QoS::from(DeliveryGuarantee::ExactlyOnce)
        );
    }
}

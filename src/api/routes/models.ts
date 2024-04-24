import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "SparkDesk-v1.1",
                        "object": "model",
                        "owned_by": "spark-free-api"
                    },
                    {
                        "id": "SparkDesk-v2.1",
                        "object": "model",
                        "owned_by": "spark-free-api"
                    },
                    {
                        "id": "SparkDesk-v3.1",
                        "object": "model",
                        "owned_by": "spark-free-api"
                    },
                    {
                        "id": "SparkDesk-v3.5",
                        "object": "model",
                        "owned_by": "spark-free-api"
                    },
                    {
                        "id": "SparkDesk-v1",
                        "object": "model",
                        "owned_by": "spark-free-api"
                    },
                    {
                        "id": "SparkDesk-v1-vision",
                        "object": "model",
                        "owned_by": "spark-free-api"
                    }
                ]
            };
        }

    }
}
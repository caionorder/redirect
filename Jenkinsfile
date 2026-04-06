pipeline {

    agent any


    stages {

        stage('Check buildx') {
            steps {
                sh 'docker buildx version'
                sh 'docker buildx ls'
            }
        }


        stage('Checkout') {
            steps {
                // Checkout do código
                checkout scm
            }
        }

        stage('Create Environment File') {
            steps {
                // Cria o arquivo .env com as variáveis necessárias
                sh '''
                cat > .env << EOL
NODE_ENV=production
# MONGODB_URL=mongodb://joinads:MiaAnahi%40Norder@10.124.0.6:27017/
MONGODB_URL=mongodb+srv://joinads:b019C7Fyc4P35hg8@private-mongodb-2a2b6805.mongo.ondigitalocean.com/
# MONGODB_URL=mongodb+srv://joinads:b019C7Fyc4P35hg8@mongodb-eb15d60d.mongo.ondigitalocean.com/
PORT=3000
WORKER_COUNT=8
EOL
                '''
            }
        }


        stage('Build and Push Docker Image') {
            steps {
                // Usa as credenciais do GitHub para login no GHCR
                withCredentials([usernamePassword(credentialsId: 'github-api-credentials', passwordVariable: 'GITHUB_TOKEN', usernameVariable: 'GITHUB_USER')]) {
                    // Login no GitHub Container Registry
                    sh 'echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USER --password-stdin'

                    // Build da imagem Docker e push para o GHCR
                    sh 'docker buildx build --platform=linux/amd64 --push --tag ghcr.io/caionorder/redirect:latest .'

                }
            }
        }

        stage('Deploy') {
            steps {
                // Usa as credenciais SSH para acessar o servidor de produção
                sshagent(['production-server']) {
                    sh '''
                        ssh -o StrictHostKeyChecking=no -p 22022 root@64.23.139.53 "
                            docker pull ghcr.io/caionorder/redirect:latest && \
                            docker stop norder-redirect || true && \
                            docker rm norder-redirect || true && \
                            docker run -d --restart=always --name norder-redirect --network joinads -p 6969:3000 ghcr.io/caionorder/redirect:latest
                        "
                    '''
                }
            }
        }

        stage('Cleanup') {
            steps {
                // Limpa o workspace do Jenkins após o build
                cleanWs()
            }
        }
    }

    post {
        success {
            echo 'Pipeline executado com sucesso!'
        }
        failure {
            echo 'Pipeline falhou. Verifique os logs para mais informações.'
        }
    }
}
